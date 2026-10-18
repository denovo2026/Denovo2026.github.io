# GHOSTWIRE

**Authorized adversary-emulation simulator — training only**

GHOSTWIRE is a safe, self-contained web app that narrates a fictional attacker campaign through the MITRE ATT&CK® kill chain. It is a **defensive / educational** product for authorized red-team and purple-team training. Every action is scripted or randomized story text plus local scoring. Nothing leaves the browser except an optional local file download you trigger yourself.

## Safety & authorized use

- **Simulation only.** No real exploitation, malware, payloads, scanning, network attacks, or C2.
- **No network I/O.** The app makes zero outbound HTTP(S) requests. There are no CDN, font, analytics, or API dependencies.
- **Fictional data.** Hostnames, users, and IPs are invented for narrative flavor.
- **ATT&CK labels only.** Technique IDs and names are used as educational labels from the public MITRE ATT&CK knowledge base; the app does not implement those techniques.
- Use only in authorized training contexts. Do not present GHOSTWIRE output as evidence of real compromise.

MITRE ATT&CK® is a registered trademark of The MITRE Corporation.

## Features

- AI operator auto-plays a campaign across all 13 ATT&CK kill-chain phases (Reconnaissance → Impact).
- Each step picks a plausible ATT&CK technique (real IDs/names) and writes a fictional terminal log line.
- Techniques roll against a configurable **blue-team detection maturity** (Low / Med / High) → DETECTED or MISSED.
- Live dashboard:
  - Animated terminal-style feed (CRT / matrix vibe)
  - Kill-chain progress tracker
  - Detection / missed / noise / risk meters
  - ATT&CK technique coverage grid
  - After-action report with timeline, gaps, and defensive recommendations
- Controls: Start / Pause / Step / Reset, speed slider, maturity, AI aggressiveness, target profile (Corp Windows AD, Cloud SaaS, OT/ICS).
- **Export report** as `.txt` or `.json` (local Blob download).
- Settings and high-level stats persisted in `localStorage`.
- Responsive dark “hacker” UI; PWA-friendly meta tags for home-screen add on iPhone.
- Single-file offline app — works on GitHub Pages with no build step.

## How to run

1. Open `index.html` in any modern browser (Chrome, Firefox, Safari, Edge), **or**
2. Serve the folder with any static file server, for example:

```bash
cd ghostwire
python3 -m http.server 8080
# then visit http://localhost:8080
```

No install, no build, no internet required after the file is on disk.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Entire app (inline CSS + JS) |
| `README.md` | This document |

## Ethics note

GHOSTWIRE exists to help defenders practice kill-chain thinking, detection coverage analysis, and after-action reporting in a **harmless** sandbox. If you need real adversary emulation against live systems, use properly authorized commercial or open-source frameworks under a written rules-of-engagement — not this simulator.
