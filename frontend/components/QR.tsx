"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * The link, as something you can point a phone at.
 *
 * The recipient is usually on a different device from whoever created the
 * intent — that is rather the point of a link that carries a permission —
 * and the alternative to a code is reading a URL aloud or emailing it to
 * yourself.
 *
 * Drawn as an SVG rather than a canvas so it stays sharp when scaled or
 * printed, and rendered at a high error-correction level because the most
 * likely reading conditions are a phone camera pointed at a laptop screen
 * across a table, at an angle, in a room lit for humans rather than for
 * cameras.
 */
export function QR({ value, size = 168 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, {
      type: "svg",
      errorCorrectionLevel: "H",
      margin: 1,
      // Deep navy on white. Inverted or low-contrast codes are a common
      // way to make a QR that looks designed and does not scan.
      color: { dark: "#06182eff", light: "#ffffffff" },
    })
      .then((out) => alive && setSvg(out))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [value]);

  if (failed) return null;

  return (
    <div
      className="grid shrink-0 place-items-center rounded-xl border-2 border-ink bg-white p-2 shadow-[4px_4px_0_0_var(--color-ink)]"
      style={{ width: size, height: size }}
    >
      {svg ? (
        <div
          className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
          // qrcode renders a self-contained SVG from a string we control.
          dangerouslySetInnerHTML={{ __html: svg }}
          aria-label="QR code for this intent link"
          role="img"
        />
      ) : (
        <div className="h-full w-full animate-pulse rounded bg-sky" aria-hidden />
      )}
    </div>
  );
}
