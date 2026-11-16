declare module "qrcode-terminal" {
  export function generate(text: string, opts: { small?: boolean }, cb: (code: string) => void): void;
  export function generate(text: string, cb: (code: string) => void): void;
  const _default: { generate: typeof generate };
  export default _default;
}
