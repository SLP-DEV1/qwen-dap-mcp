import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

function replace(path, oldText, newText) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(oldText)) throw new Error(`Anchor not found in ${path}: ${oldText.slice(0, 120)}`);
  writeFileSync(path, text.replace(oldText, newText), 'utf8');
}

replace(
  'src/dap/session.ts',
  "  activeRequest?: 'launch' | 'attach';\n  capabilities?: DebugProtocol.Capabilities;",
  "  activeRequest?: 'launch' | 'attach';\n  adapterId?: string;\n  capabilities?: DebugProtocol.Capabilities;",
);

replace(
  'src/dap/session.ts',
  "  private activeRequest?: 'launch' | 'attach';\n  private capabilities?: DebugProtocol.Capabilities;",
  "  private activeRequest?: 'launch' | 'attach';\n  private adapterId?: string;\n  private capabilities?: DebugProtocol.Capabilities;",
);

replace(
  'src/dap/session.ts',
  "      this.capabilities = (response.body ?? {}) as DebugProtocol.Capabilities;\n      this.initialized = true;",
  "      this.capabilities = (response.body ?? {}) as DebugProtocol.Capabilities;\n      this.adapterId = options.adapterId;\n      this.initialized = true;",
);

replace(
  'src/dap/session.ts',
  "      ...(this.activeRequest === undefined ? {} : { activeRequest: this.activeRequest }),\n      ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),",
  "      ...(this.activeRequest === undefined ? {} : { activeRequest: this.activeRequest }),\n      ...(this.adapterId === undefined ? {} : { adapterId: this.adapterId }),\n      ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),",
);

replace(
  'src/dap/session.ts',
  "    this.activeRequest = undefined;\n    this.capabilities = undefined;\n    this.dataBreakpoints = [];",
  "    this.activeRequest = undefined;\n    this.adapterId = undefined;\n    this.capabilities = undefined;\n    this.dataBreakpoints = [];",
);

unlinkSync(new URL(import.meta.url));
