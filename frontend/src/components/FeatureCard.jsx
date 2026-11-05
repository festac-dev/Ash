import { useEffect, useRef } from "react";

// Only pointer users who interact with a card load the small Motion/WAAPI runtime.
export function DepthCard({ reduced, children, className = "", as: Tag = "article" }) {
  const ref = useRef();
  const hovered = useRef(false);
  const animation = useRef(null);
  useEffect(() => {
    if (reduced) {
      animation.current?.stop();
      if (ref.current) ref.current.style.transform = "";
    }
    return () => animation.current?.stop();
  }, [reduced]);
  const tilt = async (event, active) => {
    if (event.pointerType !== "mouse" || reduced) return;
    hovered.current = active;
    const element = ref.current;
    try {
      const { animate } = await import("framer-motion/dom/mini");
      if (!element?.isConnected || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      animation.current?.stop();
      animation.current = animate(
        element,
        { transform: hovered.current ? "translateY(-4px) rotateX(1deg)" : "translateY(0px) rotateX(0deg)" },
        { duration: 0.3, ease: "easeOut" },
      );
    } catch {
      /* Decorative motion is optional; the card remains readable. */
    }
  };
  return (
    <Tag
      ref={ref}
      className={`depth-card ${className}`}
      onPointerEnter={(event) => tilt(event, true)}
      onPointerLeave={(event) => tilt(event, false)}
    >
      {children}
    </Tag>
  );
}

export function FeatureCard({ reduced, children }) {
  return (
    <DepthCard reduced={reduced} className="feature-card">
      {children}
    </DepthCard>
  );
}
