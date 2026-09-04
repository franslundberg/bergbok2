import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { companySummary } from "@/lib/bergbok/application";
import { errorResponse } from "@/lib/bergbok/http";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    requireOwner(request);
    return NextResponse.json(await companySummary(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
