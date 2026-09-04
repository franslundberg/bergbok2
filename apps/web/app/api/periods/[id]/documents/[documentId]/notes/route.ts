import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { addDocumentNote } from "@/lib/bergbok/application";
import { assertSameOrigin, errorResponse, jsonBody } from "@/lib/bergbok/http";
import { parseDocumentNote } from "@/lib/bergbok/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = requireOwner(request);
    const input = parseDocumentNote(await jsonBody(request));
    const value = await params;
    return NextResponse.json(
      await addDocumentNote(session, value.id, value.documentId, input.markdown),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
