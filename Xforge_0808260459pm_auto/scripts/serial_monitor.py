#!/usr/bin/env python3
import argparse, json, sys, time
try:
    import serial
except ImportError:
    print(json.dumps({"ok": False, "error": "pyserial not installed. Run: pip install pyserial"})); sys.exit(1)
ap = argparse.ArgumentParser()
ap.add_argument("--port", required=True); ap.add_argument("--baud", type=int, default=9600)
ap.add_argument("--duration", type=float, default=5.0); ap.add_argument("--max-lines", type=int, default=0)
args = ap.parse_args()
lines = []
try:
    with serial.Serial(args.port, args.baud, timeout=0.5) as ser:
        start = time.time()
        while time.time() - start < args.duration:
            if args.max_lines and len(lines) >= args.max_lines: break
            raw = ser.readline()
            if raw: lines.append(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
    print(json.dumps({"ok": True, "port": args.port, "baud": args.baud, "lines": lines}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)})); sys.exit(1)
