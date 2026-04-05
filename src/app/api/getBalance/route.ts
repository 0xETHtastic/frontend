import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user");
  const token = req.nextUrl.searchParams.get("token") ?? "0x0000000000000000000000000000000000000000";

  if (!user) {
    return NextResponse.json({ error: "user is required" }, { status: 400 });
  }

  const url = `https://ethastic-api.up.railway.app/getBalance?user=${encodeURIComponent(user)}&token=${encodeURIComponent(token)}`;
  console.log("[API Route] getBalance:", url);

  const response = await fetch(url);
  const data = await response.json();
  console.log("[API Route] getBalance response:", data);
  return NextResponse.json(data, { status: response.status });
}
