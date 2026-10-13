"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { saveSiteProfile } from "@/lib/actions/site-profile-actions";

interface Props {
  blogId: string;
  neighborhood: string | null;
  signatureFacts: string[];
  doesNot: string[];
  placeNote: string | null;
}

export function SiteProfileCard(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [neighborhood, setNeighborhood] = useState(props.neighborhood ?? "");
  const [facts, setFacts] = useState(props.signatureFacts.join("\n"));
  const [doesNot, setDoesNot] = useState(props.doesNot.join("\n"));
  const [placeNote, setPlaceNote] = useState(props.placeNote ?? "");

  function save() {
    start(async () => {
      const result = await saveSiteProfile(props.blogId, {
        neighborhood,
        signatureFacts: facts.split(/\r?\n/),
        doesNot: doesNot.split(/\r?\n/),
        placeNote,
      });
      if (result.success) toast.success(result.message);
      else toast.error(result.message);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Site profile</CardTitle>
        <CardDescription>
          Facts only this business can claim. A local page is skipped until
          there are 3 facts and a neighborhood or place note. The model is
          not allowed to fill the gaps.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="block text-sm">
          Neighborhood
          <input
            value={neighborhood}
            onChange={(e) => setNeighborhood(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
            placeholder="Plateau, not Montreal"
          />
        </label>
        <label className="block text-sm">
          Signature facts, one per line
          <textarea
            value={facts}
            onChange={(e) => setFacts(e.target.value)}
            rows={5}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-sm">
          What it does not do, one per line
          <textarea
            value={doesNot}
            onChange={(e) => setDoesNot(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-sm">
          Place note, sourced
          <textarea
            value={placeNote}
            onChange={(e) => setPlaceNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            placeholder="4 minutes from Sherbrooke station. Do not invent this."
          />
        </label>
        <Button size="sm" disabled={pending} onClick={save}>
          Save profile
        </Button>
      </CardContent>
    </Card>
  );
}
