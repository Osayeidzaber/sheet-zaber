"use server"

import { revalidatePath } from "next/cache"

import { isActionError } from "@/lib/action-result"
import { disconnectGoogleAction as disconnectGoogleVerb } from "@/server/actions/connections"

export type DisconnectState =
  | { status: "idle" }
  | { status: "error"; message: string; code: string; fields?: Record<string, string> }
  | { status: "success"; id: string }

/** Adapt the confirmation form; the backend action re-checks session and ownership. */
export async function disconnectGoogleAction(
  _previous: DisconnectState,
  formData: FormData
): Promise<DisconnectState> {
  const value = formData.get("connectionId")
  const connectionId = typeof value === "string" ? value.trim() : ""
  const result = await disconnectGoogleVerb(connectionId)

  if (isActionError(result)) {
    return {
      status: "error",
      message: result.error.message,
      code: result.error.code,
      ...(result.error.fields === undefined ? {} : { fields: result.error.fields }),
    }
  }

  // Removing a grant also cascades its spreadsheets and endpoints.
  revalidatePath("/settings")
  revalidatePath("/spreadsheets", "layout")
  revalidatePath("/apis", "layout")
  revalidatePath("/keys")
  revalidatePath("/overview")

  return { status: "success", id: result.data.id }
}
