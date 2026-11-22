"""Build Sim Lab: python3 viz/build.py model_week.json [out.html] [--picks | --picks-hidden]
--picks adds the Picks tab, --fantasy the Fantasy tab. Since 10 Nov 2026 the shared Sim Lab carries both (owner's decision); the public GitHub file carries Fantasy only."""
import base64, json, sys, os
here = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
picks = "--picks" in sys.argv or "--picks-hidden" in sys.argv
playoffs = "--playoffs" in sys.argv   # Playoffs tab (season simulation, pre-calculated in viz/playoffs.json)
fantasy = "--fantasy" in sys.argv   # Fantasy tab (rankings, start/sit)
hidden = "--picks-hidden" in sys.argv   # Picks code kept and reachable at #picks, but no tab shown
t = open(os.path.join(here, 'template.html')).read()
logo = base64.b64encode(open(os.path.join(here, 'wordmark.jpg'), 'rb').read()).decode()
data = json.dumps(json.load(open(args[0])), separators=(",", ":")).replace('</', '<\\/')
core = open(os.path.join(here, 'simcore.js')).read().replace('</script', '<\\/script')
nav = '\n      <a href="#picks" data-view="picks">Picks</a>' if picks and not hidden else ''
sec = open(os.path.join(here, 'picks_section.html')).read() if picks else ''
pjs = open(os.path.join(here, 'picks.js')).read().replace('</script', '<\\/script') if picks else ''
if playoffs:
    nav += '\n      <a href="#playoffs" data-view="playoffs">Playoffs</a>'
    sec += open(os.path.join(here, 'playoffs_section.html')).read()
    pjs += '\n' + open(os.path.join(here, 'playoffs.js')).read().replace('</script', '<\\/script')
if fantasy:
    nav += '\n      <a href="#fantasy" data-view="fantasy">Fantasy</a>'
    sec += open(os.path.join(here, 'fantasy_section.html')).read()
    pjs += '\n' + open(os.path.join(here, 'fantasy.js')).read().replace('</script', '<\\/script')
# pre-calculated "at a glance" numbers and last week's record (if built), so the page shows them instantly
gl = os.path.join(here, 'glance.json'); rc = os.path.join(here, 'record.json')
glance_js = ('const GLANCE = ' + (open(gl).read() if os.path.exists(gl) else 'null') + ';\nconst PLAYOFFS = ' + (open(os.path.join(here, 'playoffs.json')).read() if os.path.exists(os.path.join(here, 'playoffs.json')) else 'null') + ';\nconst RECORD = ' + (open(rc).read().strip() or 'null' if os.path.exists(rc) else 'null') + ';').replace('</', '<\\/')
t = t.replace('/*__GLANCE__*/', glance_js)
out = (t.replace('__LOGO__', logo).replace('__DATA__', data).replace('__SIMCORE__', core)
        .replace('__PICKS_NAV__', nav).replace('__PICKS_SECTION__', sec).replace('/*__PICKS_JS__*/', pjs))
if picks:
    out = out.replace('<title>Edge Sim Lab</title>', '<title>Edge Sim Lab Picks</title>', 1)
dest = args[1] if len(args) > 1 else os.path.join(here, 'edge-sim-lab-picks.html' if picks else 'edge-sim-lab.html')
open(dest, 'w').write(out)
print(dest, len(out))
