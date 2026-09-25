import { suiClient } from "@/lib/chain/client";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address) return Response.json({ error: "address is required" }, { status: 400 });

  try {
    const res = (await suiClient().core.getBalance({
      owner: address,
      coinType: "0x2::sui::SUI",
    })) as { balance?: { balance?: string } };

    return Response.json({ balance: res.balance?.balance ?? "0" });
  } catch {
    return Response.json({ balance: "0" });
  }
}
