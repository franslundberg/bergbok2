import { requireOwner } from "@/lib/bergbok/auth-http";
import { reviewContent } from "@/lib/bergbok/application";
import { errorResponse } from "@/lib/bergbok/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireOwner(request);
    const format = new URL(request.url).searchParams.get("format") ?? "html";
    if (format !== "html" && format !== "pdf" && format !== "json") {
      throw Object.assign(new Error("Ogiltigt rapportformat."), { status: 400 });
    }
    const file = await reviewContent((await params).id, format);
    const inline = format === "html";
    return new Response(file.bytes, {
      headers: {
        "Content-Type": file.mediaType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
        ...(inline
          ? {
              "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            }
          : {}),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
