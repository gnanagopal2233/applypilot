import { NextResponse } from "next/server";
import { taskState } from "../../../src/core/tasks";

export const dynamic = "force-dynamic";

export function GET() {
  const { current, history } = taskState();
  return NextResponse.json({ current, last: history[0] ?? null });
}
