"use client"

import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { CopyField } from "@/components/ui/copy"

import { createMemberCodeAction } from "./actions"

export function NewCode() {
  const [code, setCode] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="solid"
        loading={pending}
        className="w-fit"
        onClick={() =>
          start(async () => {
            const result = await createMemberCodeAction()
            if ("code" in result) {
              setCode(result.code)
              setFailure(null)
            } else {
              setFailure(result.error)
            }
          })
        }
      >
        Create invitation code
      </Button>
      {failure ? <p role="alert" className="text-[13px] text-paper">⚠ {failure}</p> : null}
      {code ? (
        <div className="reveal flex flex-col gap-2">
          <CopyField value={code} label="Invitation code (shown once)" />
          <p className="text-[13px] text-dust">Copy it now. Only a hash is stored, so it can&apos;t be shown again.</p>
        </div>
      ) : null}
    </div>
  )
}
