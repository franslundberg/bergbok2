import { NextResponse } from "next/server";
import { publicAuthState } from "@/lib/bergbok/auth-http";
import { errorResponse } from "@/lib/bergbok/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(publicAuthState(request), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
