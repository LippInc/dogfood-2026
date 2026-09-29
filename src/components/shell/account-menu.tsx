"use client";

import { ChevronDown, UserRound } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef } from "react";

/**
 * The work side's account menu: the person's name, their role here and Sign out. The trigger is the account icon,
 * with the name beside it from 2xl, where the bar has room; so the bar's other tools (the page's own, Help, the mode
 * toggle) fit from 1280 px up, the organizer's overview included. The menu is not portalled: it stays inside the
 * work frame and wears its tokens, and its fixed positioning lets it out of the bar's scrolling row. Arrow keys,
 * Enter and Escape work as in any menu.
 */
export function AccountMenu({ person, role }: { person: string; role: string }) {
  const signOut = useRef<HTMLFormElement>(null);
  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          title={`${person}, ${role}`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-14 text-ink-2 hover:bg-raised hover:text-ink data-[state=open]:bg-raised"
        >
          <UserRound className="size-4 shrink-0" aria-hidden />
          <span className="max-w-48 truncate font-medium text-ink max-2xl:sr-only">{person}</span>
          <span className="sr-only">, {role}: account</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-40 w-64 rounded-sm border border-rule bg-surface p-2 text-ink shadow-overlay"
        >
          <DropdownMenu.Label className="px-3 pt-1.5">
            <span className="block text-14 font-medium wrap-break-word">{person}</span>
            <span className="block pb-2 text-13 text-ink-3">{role}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="mb-1 border-t border-rule" />
          <DropdownMenu.Item
            onSelect={() => signOut.current?.requestSubmit()}
            className="flex h-10 cursor-pointer items-center rounded-sm px-3 text-14 outline-none data-highlighted:bg-raised"
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {/* outside the menu, which unmounts when it closes */}
      <form ref={signOut} action="/api/auth/sign-out" method="post" hidden />
    </>
  );
}
