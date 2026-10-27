// One exported function per storyboard scene id. Place every tween with at(cue, offset): absolute seconds on the master timeline.
import { $, title, pop, link, draw, packets, camera, stamp, pulse } from '/studio/recipes.js';

export function intro({ tl, at }) {
  title(tl, $('#title'), at('start', 0.2));
  pop(tl, ['#n1', '#n2', '#n3'], at('nodes'), { stagger: 0.18 });
  const a = link($('#n1'), $('#n2'));
  const b = link($('#n2'), $('#n3'), { className: 'link warm' });
  draw(tl, [a, b], at('nodes', 0.5));
  packets(tl, a, at('flow'), at('end') + 4);
  packets(tl, b, at('flow', 0.3), at('end') + 4, { className: 'packet warm' });
}

export function detail({ tl, at }) {
  camera(tl, { x: 960, y: 560, scale: 1.45 }, at('start', 0.2));
  pulse(tl, $('#n2'), at('start', 1.0));
  stamp(tl, $('#stamp'), at('stamp'));
  camera(tl, { x: 960, y: 540, scale: 1 }, at('end', -1.2), { duration: 1.0 });
}
