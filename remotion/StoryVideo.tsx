import { AbsoluteFill, Audio, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { StoryVideoProps } from "./schema";
import { activeCueAt, visibleScenesAt } from "./timeline";

/** How long one scene takes to fade into the next. */
const CROSSFADE_MS = 500;

/**
 * A scene's image, slowly zooming.
 *
 * Source frames are 432x768 upscaled to 1080x1920, so they are already being
 * enlarged; the drift is what stops a still image reading as a broken video.
 * Scaling starts above 1 so the zoom never exposes an edge.
 */
function Scene({
  src,
  opacity,
  progress,
}: {
  src: string;
  opacity: number;
  progress: number;
}) {
  const scale = interpolate(progress, [0, 1], [1.06, 1.16], {
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
function Caption({ text, style }: { text: string; style: StoryVideoProps["captionStyle"] }) {
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

export function StoryVideo({ audioSrc, scenes, cues, captionStyle }: StoryVideoProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  const visible = visibleScenesAt(nowMs, scenes, CROSSFADE_MS);

  const cue = activeCueAt(nowMs, cues);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {visible.map((entry) => (
        <Scene
          key={entry.scene.src}
          src={entry.scene.src}
          opacity={entry.opacity}
          progress={entry.progress}
        />
      ))}

      {cue && <Caption text={cue.text} style={captionStyle} />}

      <Audio src={staticFile(audioSrc)} />
    </AbsoluteFill>
  );
}
