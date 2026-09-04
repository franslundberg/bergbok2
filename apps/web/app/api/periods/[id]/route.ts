import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { periodDetail } from "@/lib/bergbok/application";
import { errorResponse } from "@/lib/bergbok/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireOwner(request);
    return NextResponse.json(await periodDetail((await params).id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
