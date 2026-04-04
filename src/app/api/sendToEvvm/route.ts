import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  console.log("[API Route] Received body:", rawBody);

  const response = await fetch("http://localhost:3001/sendToEvvm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });

  const data = await response.json();
  console.log("[API Route] Backend response:", data);
  return NextResponse.json(data, { status: response.status });
}
