"""Data layer: download + cache nflverse files, and build tidy tables the engine uses."""
from __future__ import annotations
import os
import urllib.request
import pandas as pd

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
CACHE = os.environ.get("EDGE_CACHE", os.path.join(os.path.dirname(__file__), "..", "data"))

FILES = {
    "games": ("schedules/games.parquet", "games.parquet"),
    "pbp": ("pbp/play_by_play_{y}.parquet", "pbp{y}.parquet"),
    "players": ("stats_player/stats_player_week_{y}.parquet", "sp{y}.parquet"),
    "injuries": ("injuries/injuries_{y}.parquet", "inj{y}.parquet"),
    "rosters": ("weekly_rosters/roster_weekly_{y}.parquet", "rw{y}.parquet"),
}


def _path(kind: str, year: int | None = None, refresh: bool = False) -> str:
    remote, local = FILES[kind]
    remote, local = remote.format(y=year), local.format(y=year)
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, local)
    if refresh or not os.path.exists(p):
        urllib.request.urlretrieve(f"{BASE}/{remote}", p)
    return p


def games(refresh=False) -> pd.DataFrame:
    g = pd.read_parquet(_path("games", refresh=refresh))
    return g[g.game_type.isin(["REG", "WC", "DIV", "CON", "SB"])]


def pbp(years, refresh=False) -> pd.DataFrame:
    cols = ["game_id", "season", "week", "posteam", "defteam", "home_team", "away_team", "fixed_drive",
            "fixed_drive_result", "play_type", "yards_gained", "pass_attempt", "rush_attempt", "sack",
            "yardline_100", "rusher_player_id", "receiver_player_id", "passer_player_id", "rush_touchdown",
            "pass_touchdown", "td_player_id", "epa", "qb_kneel", "qb_spike", "two_point_attempt"]
    out = []
    for y in years:
        d = pd.read_parquet(_path("pbp", y, refresh), columns=cols)
        out.append(d)
    return pd.concat(out, ignore_index=True)


def players(years, refresh=False) -> pd.DataFrame:
    return pd.concat([pd.read_parquet(_path("players", y, refresh)) for y in years], ignore_index=True)


def injuries(year, refresh=False) -> pd.DataFrame:
    return pd.read_parquet(_path("injuries", year, refresh))


def rosters(year, refresh=False) -> pd.DataFrame:
    return pd.read_parquet(_path("rosters", year, refresh))


def game_index(g: pd.DataFrame) -> pd.Series:
    """Chronological order key so ratings only ever use games played before the target game."""
    return g.season * 100 + g.week


def team_drives(p: pd.DataFrame) -> pd.DataFrame:
    """One row per offensive drive: team, opponent, outcome, yards, pass/rush yards."""
    p = p[p.posteam.notna() & p.fixed_drive.notna()].copy()
    p["pass_yds"] = p.yards_gained.where((p.pass_attempt == 1) & (p.sack == 0), 0).fillna(0)
    p["rush_yds"] = p.yards_gained.where(p.rush_attempt == 1, 0).fillna(0)
    agg = p.groupby(["game_id", "season", "week", "posteam", "defteam", "fixed_drive"]).agg(
        result=("fixed_drive_result", "first"), yards=("yards_gained", "sum"),
        pass_yds=("pass_yds", "sum"), rush_yds=("rush_yds", "sum"),
        passes=("pass_attempt", "sum"), rushes=("rush_attempt", "sum")).reset_index()
    agg["td"] = (agg.result == "Touchdown").astype(int)
    agg["fg"] = (agg.result == "Field goal").astype(int)
    return agg


def team_games(drives: pd.DataFrame) -> pd.DataFrame:
    """One row per team-game: offensive drive counts and outcome rates (the rating inputs)."""
    tg = drives.groupby(["game_id", "season", "week", "posteam", "defteam"]).agg(
        drives=("fixed_drive", "size"), td=("td", "sum"), fg=("fg", "sum"),
        pass_yds=("pass_yds", "sum"), rush_yds=("rush_yds", "sum"),
        passes=("passes", "sum"), rushes=("rushes", "sum")).reset_index()
    tg["order"] = tg.season * 100 + tg.week
    return tg
