/*
  动画库的「功能包」单独一个文件，只为了让它成为一个独立的 chunk。

  App.tsx 里 LazyMotion 的 features 传的是这个文件的动态 import：入口包里只剩
  LazyMotion + m.*（几 KB），淡入淡出的实现（domAnimation，压缩前约 300 KB 源码）
  在首屏画完之后才到 —— 到之前 m.* 元素直接以最终状态显示，不动，不闪。
*/
import { domAnimation } from "motion/react";

export default domAnimation;
