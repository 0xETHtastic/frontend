import { createSignerWithViem } from "@evvm/evvm-js";
import { getWalletClient, getChainId } from "wagmi/actions";
import { config } from "@/config";

export async function getEvvmSigner() {
  const walletClient = await getWalletClient(config);
  if (!walletClient) {
    throw new Error("Wallet not connected");
  }
  // cast to any to avoid cross-package `viem` type incompatibilities
  return createSignerWithViem(walletClient as unknown as any);
}

export function getCurrentChainId(): number {
  return getChainId(config);
}