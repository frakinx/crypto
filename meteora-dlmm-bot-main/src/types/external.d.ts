declare module 'bs58' {
  interface Bs58 {
    decode(input: string | Uint8Array): Uint8Array;
    encode(input: Uint8Array | number[]): string;
  }

  const bs58: Bs58;
  export default bs58;
}

