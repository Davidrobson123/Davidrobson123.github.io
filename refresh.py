"""Rebuild the Edge Sim Lab page from the latest nflverse data (run by GitHub Actions on a timetable).
Works out the current NFL week, exports the model with today's injury reports and rosters, applies roles.json,
checks starting quarterbacks, pre-calculates the at-a-glance numbers and writes index.html."""
import os, sys, json, subprocess, urllib.request, datetime
import pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE); os.makedirs("data", exist_ok=True)
def run(*a): print("$", " ".join(a), flush=True); subprocess.run(a, check=True)
# 1. which week: the earliest regular-season week of this season with a game still to play
urllib.request.urlretrieve("https://github.com/nflverse/nflverse-data/releases/download/schedules/games.parquet", "data/games.parquet")
g = pd.read_parquet("data/games.parquet"); season = int(os.environ.get("SEASON", g.season.max()))
g = g[g.season == season]; reg = g[g.game_type == "REG"]
left = reg[reg.home_score.isna()]
if left.empty: left = g[g.home_score.isna()]   # regular season over: build the playoff weeks
if left.empty:
    print("Season finished: nothing to build.")
    if os.environ.get("GITHUB_OUTPUT"): open(os.environ["GITHUB_OUTPUT"], "a").write("changed=false\n")
    sys.exit(0)
week = int(os.environ.get("WEEK", left.week.min())); print("season", season, "week", week)
# 2. model with fresh injury reports and rosters, then hand roles, QB checks and stadium locations
run(sys.executable, "export_model.py", str(season), str(week), "model_week.json")
run(sys.executable, "set_roles.py", "model_week.json")
run(sys.executable, "add_qb_entries.py", "model_week.json")
run(sys.executable, "add_geo.py", "model_week.json")
mj = json.load(open("model_week.json")); mj["auto"] = True; json.dump(mj, open("model_week.json", "w"))
# 2b. skip the rebuild when nothing in the data has changed since the last run (runs every 30 minutes)
import hashlib
m = json.load(open("model_week.json")); m.pop("generated", None)
fp = hashlib.sha256((json.dumps(m, sort_keys=True) + open("roles.json").read()).encode()).hexdigest()[:16]
prev = open("data_fingerprint.txt").read().strip() if os.path.exists("data_fingerprint.txt") else ""
def tell(changed):   # lets the workflow know whether to publish
    if os.environ.get("GITHUB_OUTPUT"): open(os.environ["GITHUB_OUTPUT"], "a").write(f"changed={'true' if changed else 'false'}\n")
if fp == prev and os.path.exists("index.html") and os.environ.get("FORCE") != "1":
    print("No new data since the last build: page left as it is."); tell(False); sys.exit(0)
open("data_fingerprint.txt", "w").write(fp + "\n")
# 3. pre-calculated at-a-glance numbers and playoff chances, safety checks, prediction history, then the page
run("node", "glance.js", "model_week.json", "viz/glance.json")
po = not reg[reg.home_score.isna()].empty
if po: run(sys.executable, "playoffs.py", "model_week.json", "viz/playoffs.json", "10000")
elif os.path.exists("viz/playoffs.json"): os.remove("viz/playoffs.json")   # regular season over: no playoff-chances tab
try: run(sys.executable, "checks.py", "model_week.json", "viz/glance.json", *(["viz/playoffs.json"] if po else []))
except subprocess.CalledProcessError:
    if os.path.exists("data_fingerprint.txt"): os.remove("data_fingerprint.txt")   # try again next hour
    raise
run(sys.executable, "history.py", "model_week.json", "viz/glance.json")
run(sys.executable, "viz/build.py", "model_week.json", "build.html", "--picks", "--fantasy", *(["--playoffs"] if po else []))
s = open("build.html", encoding="utf-8").read(); i = s.index('<div class="wrap">')
head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="robots" content="noindex, nofollow, noarchive">\n<meta name="description" content="The Edge Sim Lab: NFL game simulations, picks and fantasy rankings.">\n'
        '<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🏈</text></svg>">\n')
open("index.html", "w", encoding="utf-8").write(head + s[:i] + "</head>\n<body>\n" + s[i:] + "\n</body>\n</html>\n")
os.remove("build.html"); tell(True); print("index.html written", datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M"), "UTC")
