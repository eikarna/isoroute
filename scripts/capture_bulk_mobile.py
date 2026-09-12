import json
import time
import urllib.request
import websocket

# Connect to Brave CDP
res = urllib.request.urlopen("http://127.0.0.1:9222/json")
tabs = json.loads(res.read().decode())
target = None
for t in tabs:
    if t.get("type") == "page":
        target = t
        break

if not target:
    # create new tab
    req = urllib.request.Request("http://127.0.0.1:9222/json/new?http://127.0.0.1:20129/admin/dashboard", method="PUT")
    target = json.loads(urllib.request.urlopen(req).read().decode())

ws_url = target["webSocketDebuggerUrl"]
ws = websocket.create_connection(ws_url)

def send_cmd(method, params=None):
    msg_id = int(time.time() * 1000) % 1000000
    msg = {"id": msg_id, "method": method}
    if params:
        msg["params"] = params
    ws.send(json.dumps(msg))
    while True:
        resp = json.loads(ws.recv())
        if resp.get("id") == msg_id:
            return resp

# Set mobile device emulation (390 x 844)
send_cmd("Emulation.setDeviceMetricsOverride", {
    "width": 390,
    "height": 844,
    "deviceScaleFactor": 2,
    "mobile": True
})

send_cmd("Page.navigate", {"url": "http://127.0.0.1:20129/admin/dashboard"})
time.sleep(1.5)

# Login automatically if prompted
eval_res = send_cmd("Runtime.evaluate", {
    "expression": """(() => {
        const inp = document.querySelector('input[type="password"]');
        if (inp) {
            inp.value = "iso_adm_KIWTm3LR5dN9NkY8J34x";
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const btn = document.querySelector('button.btn-brand');
            if (btn) btn.click();
            return "LOGGED_IN";
        }
        return "ALREADY_LOGGED_IN";
    })()"""
})
time.sleep(1.5)

# Click 'Providers' tab and then '⚡ Bulk' tab
send_cmd("Runtime.evaluate", {
    "expression": """(() => {
        const navBtns = Array.from(document.querySelectorAll('.nav-item'));
        const provNav = navBtns.find(b => b.innerText.includes('Providers'));
        if (provNav) provNav.click();
        
        setTimeout(() => {
            const subBtns = Array.from(document.querySelectorAll('.subtab-btn'));
            const bulkBtn = subBtns.find(b => b.innerText.includes('Bulk'));
            if (bulkBtn) bulkBtn.click();
        }, 300);
    })()"""
})
time.sleep(1.5)

# Capture screenshot
shot = send_cmd("Page.captureScreenshot", {"format": "png"})
import base64
with open("verified_bulk_mobile.png", "wb") as f:
    f.write(base64.b64decode(shot["result"]["data"]))

print("Saved verified_bulk_mobile.png")
ws.close()
