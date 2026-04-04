import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  console.log("[API Route] executeCrosschain body:", rawBody);

  const response = await fetch("https://ethastic-api.up.railway.app/executeCrosschain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });

  const data = await response.json();
  console.log("[API Route] executeCrosschain response:", data);
  return NextResponse.json(data, { status: response.status });
}
