import { requireOwner } from "@/lib/bergbok/auth-http";
import { artifactContent } from "@/lib/bergbok/application";
import { errorResponse } from "@/lib/bergbok/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireOwner(request);
    const file = await artifactContent((await params).id);
    return new Response(file.bytes, {
      headers: {
        "Content-Type": file.mediaType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
