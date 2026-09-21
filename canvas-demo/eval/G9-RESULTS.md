# G9 Canvas Render Eval

This repository contains the deterministic G9 runner, the 18-case input corpus, and a portable HTML report. The raw Chromium screenshots and DOM artifacts are intentionally kept out of the Git tree; CI can archive them as run artifacts when needed.

- Cases: 18/18 passed
- Trajectory events: 113
- Live and replay captures: 187
- Screenshot surfaces captured locally: 561
- Source revision: `9e9e94a`

Run the eval locally with:

```bash
npm run eval:run -- --run-id local-g9
npm run eval:validate -- eval/runs/local-g9
```

Open `eval/G9-REPORT.html` for the portable report. It embeds one representative canvas screenshot per case, so it remains viewable after cloning without the raw artifact directory.
