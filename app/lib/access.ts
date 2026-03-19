// Paywall removed — all connected wallets can access the dashboard.
// MASTER_ADDRESSES kept for internal reference only.
export const MASTER_ADDRESSES = [
  "0xfc77ff29178b7286a8ba703d7a70895ca74ff466",
  "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28",
  "0x3717D6Ed5C2BCe558E715cDa158023dB6705fD47",
];

/** Always returns true — paywall has been removed. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function isPaid(_address: string): boolean {
  return true;
}

/** No-op — kept for backward compatibility. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setPaid(_address: string) {}
