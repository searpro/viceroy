import { AbsoluteFill, Audio, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { StoryVideoProps } from "./schema";
import { activeCueAt, visibleShotsAt } from "./timeline";

/**
 * The longest a shot takes to fade into the next.
 *
 * A ceiling, not a constant: `crossfadeFor` shortens it on a shot too brief to
 * spend half a second dissolving, which since M9 is most of them.
 */
const CROSSFADE_MS = 500;

/**
 * A shot's image, slowly zooming.
 *
 * Source frames are 432x768 upscaled to 1080x1920, so they are already being
 * enlarged; the drift is what stops a still image reading as a broken video.
 * Scaling starts above 1 so the zoom never exposes an edge.
 *
 * The zoom is scaled by how long the shot holds. A fixed 1.06→1.16 travel was
 * a slow drift across a fifteen-second scene and would be a lurch across a
 * 1.5-second one, so the shot's own duration sets how far it actually gets —
 * capped at the original travel, so nothing moves faster than it used to.
 */
function Shot({
  src,
  opacity,
  progress,
  durationMs,
}: {
  src: string;
  opacity: number;
  progress: number;
  durationMs: number;
}) {
  const travel = Math.min(0.1, (0.1 * durationMs) / 15_000);
  const scale = interpolate(progress, [0, 1], [1.06, 1.06 + travel], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={staticFile(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
}

/**
 * The caption for the current moment.
 *
 * Text is painted twice — a thick stroked copy underneath, the fill on top —
 * because these are watched over arbitrary imagery and a drop shadow alone
 * disappears against a bright frame. `paintOrder: stroke` keeps the outline
 * outside the glyph rather than eating into it.
 */
export function Caption({ text, style }: { text: string; style: StoryVideoProps["captionStyle"] }) {
  const { height } = useVideoConfig();

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: height * style.bottomOffset,
        paddingLeft: 80,
        paddingRight: 80,
      }}
    >
      <span
        style={{
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          color: style.color,
          textAlign: "center",
          lineHeight: 1.2,
          textTransform: style.uppercase ? "uppercase" : "none",
          WebkitTextStroke: `${style.outlineWidth}px ${style.outlineColor}`,
          paintOrder: "stroke fill",
          textWrap: "balance",
        }}
      >
        {text}
      </span>
    </AbsoluteFill>
  );
}

export function StoryVideo({ audioSrc, shots, cues, captionStyle }: StoryVideoProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  const visible = visibleShotsAt(nowMs, shots, CROSSFADE_MS);

  const cue = activeCueAt(nowMs, cues);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {visible.map((entry) => (
        <Shot
          key={entry.shot.src}
          src={entry.shot.src}
          opacity={entry.opacity}
          progress={entry.progress}
          durationMs={entry.shot.endMs - entry.shot.startMs}
        />
      ))}

      {cue && <Caption text={cue.text} style={captionStyle} />}

      <Audio src={staticFile(audioSrc)} />
    </AbsoluteFill>
  );
}
