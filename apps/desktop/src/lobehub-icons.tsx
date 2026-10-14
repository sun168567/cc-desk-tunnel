import type { CSSProperties, HTMLAttributes, SVGProps } from 'react';

const COLOR_PRIMARY = '#D97757';
const AVATAR_BACKGROUND = COLOR_PRIMARY;
const AVATAR_COLOR = '#fff';
const AVATAR_ICON_MULTIPLE = 0.68;
const COMBINE_TEXT_MULTIPLE = 0.78;
const COMBINE_SPACE_MULTIPLE = 0.12;

const CLAUDE_ICON_PATH =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

const CLAUDE_TEXT_PATH =
  'M13.623 20.222c-3.417 0-5.753-1.901-6.855-4.827a12.992 12.992 0 01-.838-4.772c0-4.907 2.206-8.315 7.08-8.315 3.275 0 5.297 1.425 6.448 4.826h1.402l-.19-4.69C18.709 1.18 16.258.543 13.276.543c-4.2 0-7.775 1.874-9.763 5.254a11.357 11.357 0 00-1.511 5.872c0 3.753 1.777 7.08 5.113 8.926a11.95 11.95 0 005.943 1.398c3.254 0 5.835-.617 8.122-1.697l.593-5.172h-1.43c-.858 2.362-1.88 3.78-3.574 4.534-.831.373-1.88.564-3.146.564zm14.74-17.914L28.499 0h-.967L23.23 1.29v.699l1.907.882v16.142c0 1.1-.565 1.344-2.043 1.528v1.18h7.319v-1.18c-1.484-.184-2.042-.428-2.042-1.528V2.315l-.007-.007zm29.104 19.685h.565l4.95-.937v-1.208l-.695-.054c-1.157-.109-1.457-.346-1.457-1.29V9.897l.137-2.763h-.783l-4.678.672v1.181l.457.082c1.266.183 1.64.536 1.64 1.419v7.67c-1.212.937-2.369 1.527-3.744 1.527-1.525 0-2.471-.774-2.471-2.58V9.905l.136-2.763h-.804l-4.684.672v1.181l.484.082c1.266.183 1.64.536 1.64 1.418v7.08c0 3 1.703 4.426 4.412 4.426 2.07 0 3.765-1.1 5.038-2.627L57.474 22l-.007-.007zm-13.602-9.55c0-3.836-2.043-5.309-5.733-5.309-3.254 0-5.616 1.344-5.616 3.57 0 .666.238 1.175.721 1.528l2.478-.326c-.109-.746-.163-1.201-.163-1.391 0-1.263.674-1.901 2.042-1.901 2.022 0 3.044 1.419 3.044 3.7v.746l-5.106 1.527c-1.702.462-2.67.863-3.316 1.8a3.386 3.386 0 00-.476 1.9c0 2.172 1.497 3.706 4.057 3.706 1.852 0 3.493-.835 4.922-2.416.51 1.581 1.294 2.416 2.69 2.416 1.13 0 2.15-.455 3.063-1.344l-.272-.937a4.363 4.363 0 01-1.178.163c-.783 0-1.157-.617-1.157-1.826v-5.607zm-6.536 7.378c-1.396 0-2.26-.808-2.26-2.226 0-.964.456-1.528 1.43-1.854l4.139-1.31v3.965c-1.321.997-2.097 1.425-3.31 1.425zm43.095 1.235v-1.208l-.701-.054c-1.158-.109-1.45-.346-1.45-1.29V2.308L78.409 0h-.974l-4.302 1.29v.699l1.906.882V8.18a6.024 6.024 0 00-3.656-1.046c-4.276 0-7.612 3.245-7.612 8.098 0 3.998 2.397 6.761 6.346 6.761 2.042 0 3.819-.99 4.922-2.525l-.136 2.525h.571l4.95-.937zm-8.96-12.313c2.043 0 3.575 1.181 3.575 3.353v6.11a4.91 4.91 0 01-3.547 1.425c-2.928 0-4.412-2.308-4.412-5.39 0-3.462 1.695-5.498 4.385-5.498zm19.424 3.055c-.381-1.792-1.484-2.81-3.016-2.81-2.288 0-3.874 1.717-3.874 4.18 0 3.646 1.934 6.008 5.059 6.008a5.858 5.858 0 005.03-2.953l.913.245c-.408 3.163-3.281 5.525-6.808 5.525-4.14 0-6.992-3.054-6.992-7.399 0-4.378 3.098-7.46 7.237-7.46 3.09 0 5.27 1.853 5.97 5.07l-10.783 3.3V14.05l7.264-2.247v-.006z';

export type ClaudeIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

export type ClaudeCombineProps = HTMLAttributes<HTMLSpanElement> & {
  size?: number;
  type?: 'color' | 'mono';
  spaceMultiple?: number;
  textMultiple?: number;
};

export type ClaudeAvatarProps = HTMLAttributes<HTMLSpanElement> & {
  size?: number;
  shape?: 'circle' | 'square';
  background?: string;
};

function ClaudeMono({ size = '1em', style, ...rest }: ClaudeIconProps) {
  return (
    <svg
      aria-hidden={rest['aria-label'] ? undefined : true}
      fill="currentColor"
      fillRule="nonzero"
      height={size}
      width={size}
      style={{ flex: 'none', lineHeight: 1, width: size, height: size, ...style }}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path d={CLAUDE_ICON_PATH} />
    </svg>
  );
}

function ClaudeColor({ size = '1em', style, ...rest }: ClaudeIconProps) {
  return (
    <svg
      aria-hidden={rest['aria-label'] ? undefined : true}
      height={size}
      width={size}
      style={{ flex: 'none', lineHeight: 1, width: size, height: size, ...style }}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path d={CLAUDE_ICON_PATH} fill={COLOR_PRIMARY} fillRule="nonzero" />
    </svg>
  );
}

function ClaudeText({ size = '1em', style, ...rest }: ClaudeIconProps) {
  return (
    <svg
      aria-hidden={rest['aria-label'] ? undefined : true}
      fill="currentColor"
      fillRule="nonzero"
      height={size}
      style={{ flex: 'none', lineHeight: 1, height: size, width: 'auto', ...style }}
      viewBox="0 0 97 24"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path d={CLAUDE_TEXT_PATH} />
    </svg>
  );
}

function ClaudeCombine({
  size = 24,
  type = 'mono',
  spaceMultiple = COMBINE_SPACE_MULTIPLE,
  textMultiple = COMBINE_TEXT_MULTIPLE,
  style,
  className,
  ...rest
}: ClaudeCombineProps) {
  const Icon = type === 'color' ? ClaudeColor : ClaudeMono;
  return (
    <span
      aria-hidden={rest['aria-label'] ? undefined : true}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        lineHeight: 1,
        gap: Math.max(4, Math.round(size * spaceMultiple * 1.8)),
        ...style,
      }}
      {...rest}
    >
      <Icon size={size} />
      <ClaudeText size={Math.round(size * textMultiple)} />
    </span>
  );
}

function ClaudeAvatar({
  size = 24,
  shape = 'circle',
  background = AVATAR_BACKGROUND,
  style,
  className,
  ...rest
}: ClaudeAvatarProps) {
  const iconSize = Math.round(size * AVATAR_ICON_MULTIPLE);
  const styleObj: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: size,
    height: size,
    borderRadius: shape === 'circle' ? '50%' : Math.max(5, Math.round(size * 0.24)),
    background,
    color: AVATAR_COLOR,
    overflow: 'hidden',
    lineHeight: 1,
    ...style,
  };
  return (
    <span
      aria-hidden={rest['aria-label'] ? undefined : true}
      className={className}
      style={styleObj}
      {...rest}
    >
      <ClaudeMono size={iconSize} />
    </span>
  );
}

export const Claude = Object.assign(ClaudeMono, {
  Color: ClaudeColor,
  Text: ClaudeText,
  Combine: ClaudeCombine,
  Avatar: ClaudeAvatar,
  colorPrimary: COLOR_PRIMARY,
  title: 'Claude',
});

export default Claude;
