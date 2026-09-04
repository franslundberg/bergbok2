import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { assignUpload } from "@/lib/bergbok/application";
import { assertSameOrigin, errorResponse, jsonBody } from "@/lib/bergbok/http";
import { parseUploadAction } from "@/lib/bergbok/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const session = requireOwner(request);
    const body = parseUploadAction(await jsonBody(request));
    return NextResponse.json(
      await assignUpload(session, (await params).id, body.action, undefined, body.periodId),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
