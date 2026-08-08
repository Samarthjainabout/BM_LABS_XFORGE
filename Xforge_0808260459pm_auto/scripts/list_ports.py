#!/usr/bin/env python3
import json, sys
try:
    from serial.tools import list_ports
except ImportError:
    print(json.dumps({"ok": False, "error": "pyserial not installed. Run: pip install pyserial"})); sys.exit(1)
ports = [{"device": p.device, "description": p.description, "hwid": p.hwid} for p in list_ports.comports()]
print(json.dumps({"ok": True, "ports": ports}))
