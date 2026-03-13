// Master addresses — always treated as paid (no payment check)
const MASTER_ADDRESSES = [
  "0xfc77ff29178b7286a8ba703d7a70895ca74ff466",
  "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28",
  "0x3717D6Ed5C2BCe558E715cDa158023dB6705fD47",
];

export function isPaid(address: string): boolean {
  const addr = address.toLowerCase();
  if (MASTER_ADDRESSES.map(a => a.toLowerCase()).includes(addr)) return true;
  if (typeof window !== "undefined") {
    return localStorage.getItem(`q402_paid_${addr}`) === "true";
  }
  return false;
}

export function setPaid(address: string) {
  if (typeof window !== "undefined") {
    localStorage.setItem(`q402_paid_${address.toLowerCase()}`, "true");
  }
}
