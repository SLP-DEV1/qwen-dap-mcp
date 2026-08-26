## Summary

Describe the debugging problem and the focused change that solves it.

## Validation

- [ ] `npm run check`
- [ ] Added or updated regression coverage where practical
- [ ] Tested the relevant live/dump/packaging workflow where applicable
- [ ] Removed secrets, private source, sensitive dumps, and identifying local paths from logs

## Project boundaries

- [ ] Keeps MCP transport local/stdio unless the change explicitly documents and reviews a new trust boundary
- [ ] Does not add an arbitrary shell/source-writing primitive
- [ ] Does not add unrestricted memory writes
- [ ] Keeps autonomous edits bounded and evidence-gated

## Notes

Include relevant DAP adapter versions, reproduction steps, screenshots, logs, or follow-up work.
