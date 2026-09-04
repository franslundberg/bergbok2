import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { enqueueRun } from "@/lib/bergbok/application";
import { assertSameOrigin, errorResponse } from "@/lib/bergbok/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(enqueueRun(requireOwner(request), (await params).id), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
