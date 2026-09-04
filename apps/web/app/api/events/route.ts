import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { conversationEvents } from "@/lib/bergbok/application";
import { errorResponse } from "@/lib/bergbok/http";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    requireOwner(request);
    const after = Math.max(0, Number(new URL(request.url).searchParams.get("after") ?? 0) || 0);
    return NextResponse.json(
      { events: conversationEvents(after) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
