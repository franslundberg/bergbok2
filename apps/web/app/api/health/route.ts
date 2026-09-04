import { NextResponse } from "next/server";
import { APP_NAME, APP_VERSION } from "@/lib/bergbok/app-info";

export async function GET() {
  return NextResponse.json({ status: "ok", service: APP_NAME, version: APP_VERSION });
}
