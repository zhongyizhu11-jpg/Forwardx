import { lazy, Suspense, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/*
  头像库按需加载。

  avataaars 连同它引用的 lodash 原来是跟着侧边栏的用户头像静态打进入口包的，
  登录后第一屏要先把一套卡通人脸的全部部件下完才能出来。它和二维码、验证组件
  一起拆出去之后，入口包 1464 kB → 862 kB（gzip 446 → 268 kB），头像库占了
  其中的大头。头像只是角落里 28px 的一个圆，晚半拍
  出现完全可以接受：先放一个同尺寸的灰圆占位，不挤布局。
*/
let avataaarsModule: Promise<typeof import("avataaars")> | null = null;
let avataaarsLoaded = false;
function loadAvataaars() {
  if (!avataaarsModule) {
    avataaarsModule = import("avataaars").then((module) => {
      avataaarsLoaded = true;
      return module;
    });
  }
  return avataaarsModule;
}
const Avataaars = lazy(loadAvataaars);

/*
  再晚半拍：等浏览器空闲了才去取头像库。

  拆包之后它虽然不在入口包里，但 lazy() 在头像一渲染就发请求 —— 而头像在顶栏上，
  和首页的数据请求、路由页面包同时开跑。手机上这 445 kB（gzip 125 kB）会和真正
  要看的东西抢带宽。放到 requestIdleCallback 之后：先画页面，闲下来再换头像。
  已经取过的（切页、重渲染）直接就绪，不再闪占位。
*/
function useAvataaarsReady() {
  const [ready, setReady] = useState(avataaarsLoaded);
  useEffect(() => {
    if (avataaarsLoaded) { setReady(true); return; }
    let cancelled = false;
    const start = () => { void loadAvataaars().then(() => { if (!cancelled) setReady(true); }); };
    const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => number);
    const handle = idle ? idle(start, { timeout: 3000 }) : window.setTimeout(start, 1200);
    return () => {
      cancelled = true;
      if (idle) (window as any).cancelIdleCallback?.(handle);
      else window.clearTimeout(handle);
    };
  }, []);
  return ready;
}

type GeneratedAvatarProps = {
  seed: string;
  className?: string;
};

const TOP_TYPES = [
  "NoHair",
  "Hat",
  "Turban",
  "WinterHat1",
  "LongHairBigHair",
  "LongHairBob",
  "LongHairBun",
  "LongHairCurly",
  "LongHairDreads",
  "LongHairFro",
  "LongHairMiaWallace",
  "LongHairStraight",
  "LongHairStraight2",
  "ShortHairDreads01",
  "ShortHairDreads02",
  "ShortHairFrizzle",
  "ShortHairShortCurly",
  "ShortHairShortFlat",
  "ShortHairShortRound",
  "ShortHairShortWaved",
  "ShortHairSides",
  "ShortHairTheCaesar",
  "ShortHairTheCaesarSidePart",
];

const ACCESSORY_TYPES = ["Blank", "Kurt", "Prescription01", "Prescription02", "Round", "Sunglasses", "Wayfarers"];
const HAIR_COLORS = ["Auburn", "Black", "Blonde", "BlondeGolden", "Brown", "BrownDark", "PastelPink", "Blue", "Platinum", "Red", "SilverGray"];
const FACIAL_HAIR_TYPES = ["Blank", "BeardMedium", "BeardLight", "BeardMajestic", "MoustacheFancy", "MoustacheMagnum"];
const FACIAL_HAIR_COLORS = ["Auburn", "Black", "Blonde", "BlondeGolden", "Brown", "BrownDark", "Platinum", "Red"];
const CLOTHE_TYPES = ["BlazerShirt", "BlazerSweater", "CollarSweater", "GraphicShirt", "Hoodie", "Overall", "ShirtCrewNeck", "ShirtScoopNeck", "ShirtVNeck"];
const CLOTHE_COLORS = ["Black", "Blue01", "Blue02", "Blue03", "Gray01", "Gray02", "Heather", "PastelBlue", "PastelGreen", "PastelOrange", "PastelRed", "PastelYellow", "Pink", "Red", "White"];
const GRAPHIC_TYPES = ["Skull", "SkullOutline", "Bat", "Cumbia", "Deer", "Diamond", "Hola", "Selena", "Pizza", "Resist", "Bear"];
const EYE_TYPES = ["Close", "Default", "EyeRoll", "Happy", "Side", "Squint", "Surprised", "Wink", "WinkWacky"];
const EYEBROW_TYPES = ["Default", "DefaultNatural", "FlatNatural", "RaisedExcited", "RaisedExcitedNatural", "UnibrowNatural", "UpDown", "UpDownNatural"];
const MOUTH_TYPES = ["Concerned", "Default", "Disbelief", "Eating", "Grimace", "Serious", "Smile", "Tongue", "Twinkle"];
const SKIN_COLORS = ["Tanned", "Yellow", "Pale", "Light", "Brown", "DarkBrown", "Black"];

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick<T>(items: T[], hash: number, salt: number) {
  return items[(hash + salt * 2654435761) % items.length];
}

function propsFromSeed(seed: string) {
  const hash = hashSeed(seed || "forwardx");
  return {
    avatarStyle: "Circle",
    topType: pick(TOP_TYPES, hash, 1),
    accessoriesType: pick(ACCESSORY_TYPES, hash, 2),
    hairColor: pick(HAIR_COLORS, hash, 3),
    facialHairType: pick(FACIAL_HAIR_TYPES, hash, 4),
    facialHairColor: pick(FACIAL_HAIR_COLORS, hash, 5),
    clotheType: pick(CLOTHE_TYPES, hash, 6),
    clotheColor: pick(CLOTHE_COLORS, hash, 7),
    graphicType: pick(GRAPHIC_TYPES, hash, 8),
    eyeType: pick(EYE_TYPES, hash, 9),
    eyebrowType: pick(EYEBROW_TYPES, hash, 10),
    mouthType: pick(MOUTH_TYPES, hash, 11),
    skinColor: pick(SKIN_COLORS, hash, 12),
  };
}

export function GeneratedAvatar({ seed, className }: GeneratedAvatarProps) {
  const ready = useAvataaarsReady();
  const placeholder = <span aria-hidden className={cn("block h-full w-full rounded-full bg-muted", className)} />;
  if (!ready) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <Avataaars
        {...propsFromSeed(seed)}
        className={cn("h-full w-full", className)}
        style={{ width: "100%", height: "100%" }}
      />
    </Suspense>
  );
}
