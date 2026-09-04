import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/bergbok/auth-http";
import { receiveUpload } from "@/lib/bergbok/application";
import { getDatabase } from "@/lib/bergbok/database";
import { assertSameOrigin, errorResponse } from "@/lib/bergbok/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = requireOwner(request);
    const form = await request.formData();
    const file = form.get("file");
    const periodId = form.get("periodId");
    if (!(file instanceof File))
      throw Object.assign(new Error("Välj en fil att ladda upp."), { status: 400 });
    if (periodId !== null && typeof periodId !== "string")
      throw Object.assign(new Error("Perioden är ogiltig."), { status: 400 });
    return NextResponse.json(
      await receiveUpload(session, file, getDatabase(), periodId || undefined),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
