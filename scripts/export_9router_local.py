import os
import sqlite3
import json
from datetime import datetime

db_path = os.path.expandvars(r"%APPDATA%\9router\db\data.sqlite")
if not os.path.exists(db_path):
    print(f"Error: 9Router database not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

def fetch_table(table_name):
    try:
        cur.execute(f"SELECT * FROM {table_name}")
        rows = cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            result.append(d)
        return result
    except Exception as e:
        print(f"Warning table {table_name}: {e}")
        return []

export_data = {
    "version": "2.0-live",
    "exportedAt": datetime.utcnow().isoformat() + "Z",
    "settings": fetch_table("settings"),
    "providerConnections": fetch_table("providerConnections"),
    "providerNodes": fetch_table("providerNodes"),
    "combos": fetch_table("combos"),
    "apiKeys": fetch_table("apiKeys"),
    "proxyPools": fetch_table("proxyPools"),
}

output_path = "9router-local-live.json"
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(export_data, f, indent=2)

print(f"Exported live 9Router config to {output_path} successfully!")
print(f"- Provider Nodes:       {len(export_data['providerNodes'])}")
print(f"- Provider Connections: {len(export_data['providerConnections'])}")
print(f"- Combos:               {len(export_data['combos'])}")
conn.close()
