import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import {
  documentDetail,
  removePeriodDocument,
  replaceTextDocument,
} from "@/lib/bergbok/application";
import { assertSameOrigin, errorResponse, jsonBody } from "@/lib/bergbok/http";
import { parseDocumentNote } from "@/lib/bergbok/types";

type Parameters = { params: Promise<{ id: string; documentId: string }> };

export async function GET(request: Request, { params }: Parameters) {
  try {
    requireOwner(request);
    const value = await params;
    return NextResponse.json(await documentDetail(value.id, value.documentId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Parameters) {
  try {
    assertSameOrigin(request);
    const session = requireOwner(request);
    const input = parseDocumentNote(await jsonBody(request));
    const value = await params;
    return NextResponse.json(
      await replaceTextDocument(session, value.id, value.documentId, input.markdown),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Parameters) {
  try {
    assertSameOrigin(request);
    const session = requireOwner(request);
    const value = await params;
    return NextResponse.json(await removePeriodDocument(session, value.id, value.documentId));
  } catch (error) {
    return errorResponse(error);
  }
}
