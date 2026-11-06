"use client"

import { useState, useTransition } from "react"

import { setUserCanInviteAction } from "@/app/(app)/invites/actions"
import { CheckRow } from "@/components/ui/field"

export function InviteSwitch({ userId, initial }: { userId: string; initial: boolean }) {
  const [allowed, setAllowed] = useState(initial)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="flex flex-col gap-2">
      <CheckRow
        label="Can create invitation codes"
        description="Adds an Invites page for this user. Each code is single-use and lasts 7 days."
        checked={allowed}
        disabled={pending}
        onChange={(next) =>
          start(async () => {
            const message = await setUserCanInviteAction(userId, next)
            setFailure(message)
            if (message === null) setAllowed(next)
          })
        }
      />
      {failure ? <p role="alert" className="text-[13px] text-paper">⚠ {failure}</p> : null}
    </div>
  )
}
