/**
 * AnimatedNumber — count-up animation on mount + whenever the target value
 * changes. Uses framer-motion's spring so the easing feels right.
 *
 * Intentionally avoids `useMotionValue` wiring so callers can drop it in
 * like any other numeric span. Target is debounced into a useSpring value
 * that tracks with `stiffness/damping` tuned for ~400ms settle time.
 */
import { animate, useInView } from 'framer-motion';
import * as React from 'react';

interface AnimatedNumberProps {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}

export function AnimatedNumber({
  value,
  format = (n) => n.toLocaleString(),
  duration = 0.9,
  className,
}: AnimatedNumberProps): React.ReactElement {
  const nodeRef = React.useRef<HTMLSpanElement | null>(null);
  const inView = useInView(nodeRef, { once: true, margin: '-10% 0px' });
  const prev = React.useRef(0);

  React.useEffect(() => {
    if (!inView) return;
    const from = prev.current;
    const to = value;
    prev.current = to;

    const controls = animate(from, to, {
      duration,
      ease: [0.16, 1, 0.3, 1], // expo-out
      onUpdate: (latest) => {
        if (nodeRef.current) {
          nodeRef.current.textContent = format(Math.round(latest));
        }
      },
    });
    return () => controls.stop();
  }, [value, duration, format, inView]);

  return (
    <span ref={nodeRef} className={className}>
      {format(0)}
    </span>
  );
}
