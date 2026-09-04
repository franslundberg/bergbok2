import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { createTextDocument } from "@/lib/bergbok/application";
import { assertSameOrigin, errorResponse, jsonBody } from "@/lib/bergbok/http";
import { parseTextDocument } from "@/lib/bergbok/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const session = requireOwner(request);
    const input = parseTextDocument(await jsonBody(request));
    return NextResponse.json(
      await createTextDocument(session, (await params).id, input.filename, input.markdown),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
