import { useEffect, useRef, type RefObject } from 'react';

const MIN_THUMB_WIDTH_PX = 32;

/** A horizontal scrollbar thumb pinned to the bottom of the viewport, mirroring `targetRef`'s own
 * horizontal scroll. Lets a wide table be scrolled sideways without first scrolling all the way
 * down to reach its native scrollbar — shows only while the table is wider than its container and
 * at least partly on screen.
 *
 * Driven by a requestAnimationFrame loop instead of ResizeObserver/IntersectionObserver callbacks:
 * cheap to read every frame, self-corrects regardless of what caused the table to resize (filter
 * change, async column content, font load, …), and keeps the thumb's position exactly in step with
 * native scrolling instead of lagging a scroll/resize event behind. All updates are direct DOM
 * writes (no React state), so this never triggers a re-render. */
export function FloatingScrollbar({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startClientX: number; startScrollLeft: number } | null>(null);

  useEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;

    let frame: number;
    let lastWidth = -1;
    let lastScrollWidth = -1;
    let lastLeft = -1;
    let lastScrollLeft = -1;
    let lastVisible = false;

    const render = () => {
      frame = requestAnimationFrame(render);
      const target = targetRef.current;
      if (!target) {
        if (lastVisible) {
          track.style.display = 'none';
          lastVisible = false;
        }
        return;
      }

      const bounds = target.getBoundingClientRect();
      const inViewport = bounds.bottom > 0 && bounds.top < window.innerHeight;
      const overflowing = target.scrollWidth > bounds.width + 1;
      const shouldRender = inViewport && overflowing;

      if (!shouldRender) {
        if (lastVisible) {
          track.style.display = 'none';
          lastVisible = false;
        }
        return;
      }
      if (!lastVisible) {
        track.style.display = 'block';
        lastVisible = true;
      }

      if (bounds.left !== lastLeft || bounds.width !== lastWidth) {
        track.style.left = `${bounds.left}px`;
        track.style.width = `${bounds.width}px`;
        lastLeft = bounds.left;
        lastWidth = bounds.width;
      }

      if (target.scrollWidth !== lastScrollWidth || target.scrollLeft !== lastScrollLeft || bounds.width !== lastWidth) {
        const thumbWidth = Math.max(MIN_THUMB_WIDTH_PX, (bounds.width / target.scrollWidth) * bounds.width);
        const maxThumbOffset = Math.max(0, bounds.width - thumbWidth);
        const maxScroll = Math.max(1, target.scrollWidth - bounds.width);
        const ratio = Math.min(1, Math.max(0, target.scrollLeft / maxScroll));
        thumb.style.width = `${thumbWidth}px`;
        thumb.style.transform = `translateX(${ratio * maxThumbOffset}px)`;
        lastScrollWidth = target.scrollWidth;
        lastScrollLeft = target.scrollLeft;
      }
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [targetRef]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    if (!target) return;
    event.preventDefault();
    thumbRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startClientX: event.clientX, startScrollLeft: target.scrollLeft };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    const drag = dragRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!target || !drag || !track || !thumb || drag.pointerId !== event.pointerId) return;
    const trackWidth = track.getBoundingClientRect().width;
    const thumbWidth = thumb.getBoundingClientRect().width;
    const maxThumbOffset = Math.max(1, trackWidth - thumbWidth);
    const maxScroll = Math.max(1, target.scrollWidth - trackWidth);
    const deltaX = event.clientX - drag.startClientX;
    target.scrollLeft = drag.startScrollLeft + (deltaX / maxThumbOffset) * maxScroll;
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleTrackWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    if (!target) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    target.scrollLeft += delta;
  };

  const handleTrackClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    const track = trackRef.current;
    if (!target || !track || event.target !== track) return;
    const bounds = track.getBoundingClientRect();
    const clickRatio = (event.clientX - bounds.left) / bounds.width;
    target.scrollLeft = clickRatio * Math.max(1, target.scrollWidth - bounds.width);
  };

  return (
    <div
      className="floating-scrollbar"
      ref={trackRef}
      style={{ display: 'none' }}
      onWheel={handleTrackWheel}
      onClick={handleTrackClick}
    >
      <div
        ref={thumbRef}
        className="floating-scrollbar-thumb"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}
