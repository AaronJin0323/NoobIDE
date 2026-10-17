import './authoring.css';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { Sheet, sheetButtonClass } from '../workbench/Sheet';
import { activeEditor } from './editor-handle';
import {
  closeColorPicker,
  openColorPicker,
  useColorPickerOpen,
  useCursorColor,
  type CursorColor,
} from './cursor-color';
import { formatColor, hslToRgb, parseColor, rgbToHsl, toHex, type Rgba } from './css-colors';

/**
 * S53.3: the CSS colour at the cursor in the status bar — a swatch whose accessible name and visible text carry the
 * value (state never by colour alone), and a button that opens the colour picker.
 */
export function ColorStatus() {
  const { t } = useI18n();
  const color = useCursorColor();
  if (!color) return null;
  const label = fill(t('color.status'), { value: color.text });
  return (
    <span className="editor-status-color" data-testid="cursor-color">
      <span
        className="color-swatch"
        role="img"
        aria-label={label}
        data-testid="cursor-color-swatch"
        style={{ backgroundColor: toHex(color.rgba) }}
      />
      <span aria-hidden="true">{color.text}</span>
      <button
        type="button"
        className="editor-status-hint-dismiss"
        data-testid="cursor-color-edit"
        onClick={openColorPicker}
      >
        {t('color.edit')}
      </button>
    </span>
  );
}

/** S53.3: the colour picker dialog, opened from the status bar or Edit › Edit colour at cursor. */
export function ColorPickerHost() {
  const open = useColorPickerOpen();
  const color = useCursorColor();
  if (!open) return null;
  return <ColorPickerDialog color={color} onClose={closeColorPicker} />;
}

function ColorPickerDialog({ color, onClose }: { color: CursorColor | null; onClose: () => void }) {
  const { t } = useI18n();
  const formId = useId();
  const first = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // The colour being edited. The sliders change hue / saturation / lightness; until one moves, the colour is exactly
  // the original (a round trip through whole-number HSL could shift a hex value by one).
  const original: Rgba = color?.rgba ?? { r: 0, g: 0, b: 0, a: 1 };
  const [hsl, setHsl] = useState(() => rgbToHsl(original));
  const [moved, setMoved] = useState(false);
  const rgba: Rgba = useMemo(() => (moved ? hslToRgb(hsl) : original), [moved, hsl, original]);
  const format = color?.format ?? 'hex';
  const written = formatColor(rgba, format);
  const [typed, setTyped] = useState<string | null>(null);
  const typedColor = typed === null ? null : parseColor(typed);
  const invalid = typed !== null && typedColor === null;

  const finish = () => {
    onClose();
    activeEditor()?.focus?.(); // back to the code, where the cursor still is
  };
  // The hue slider takes focus first (the sheet keeps a child's own choice); without a colour, its Close action does.
  useEffect(() => (color ? first.current : closeButton.current)?.focus(), [color]);

  const apply = () => {
    if (invalid) return;
    const value = typedColor ? typedColor.rgba : rgba;
    onClose();
    activeEditor()?.setColor?.(value);
  };

  const slider = (key: 'h' | 's' | 'l', label: string, max: number, valueText: string) => (
    <label className="color-slider">
      <span>{label}</span>
      <input
        ref={key === 'h' ? first : undefined}
        type="range"
        min={0}
        max={max}
        value={hsl[key]}
        aria-valuetext={valueText}
        data-testid={`color-${key}`}
        onChange={(event) => {
          setTyped(null);
          setMoved(true);
          setHsl({ ...hsl, [key]: Number(event.target.value) });
        }}
      />
      <span aria-hidden="true">{valueText}</span>
    </label>
  );

  // S49.1: on the shared Sheet — Close top-right and Escape cancel; the action row is Cancel → Apply (the form's
  // submit, so Enter in the value field applies too).
  return (
    <Sheet
      title={t('color.dialog.title')}
      width={480}
      className="color-dialog"
      onClose={finish}
      closeLabel={t(color ? 'color.cancel' : 'color.close')}
      testId="color-picker"
      closeTestId="color-close"
      actions={
        color ? (
          <>
            <button type="button" className={sheetButtonClass('cancel')} onClick={finish}>
              {t('color.cancel')}
            </button>
            <button
              type="submit"
              form={formId}
              className={sheetButtonClass('primary')}
              data-testid="color-apply"
              disabled={invalid}
            >
              {t('color.apply')}
            </button>
          </>
        ) : (
          <button type="button" className={sheetButtonClass('primary')} ref={closeButton} onClick={finish}>
            {t('color.close')}
          </button>
        )
      }
    >
      {!color ? (
        <div className="dialog-body">
          <p>{t('color.dialog.none')}</p>
        </div>
      ) : (
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <div className="dialog-body color-dialog-body">
            <div className="color-preview">
              <span
                className="color-swatch color-swatch-large"
                role="img"
                aria-label={fill(t('color.before'), { value: color.text })}
                style={{ backgroundColor: toHex(color.rgba) }}
              />
              <span aria-hidden="true">→</span>
              <span
                className="color-swatch color-swatch-large"
                role="img"
                data-testid="color-preview"
                aria-label={fill(t('color.after'), { value: typedColor ? (typed ?? '') : written })}
                style={{ backgroundColor: toHex(typedColor ? typedColor.rgba : rgba) }}
              />
            </div>
            {slider('h', t('color.hue'), 360, fill(t('color.degrees'), { value: String(hsl.h) }))}
            {slider('s', t('color.saturation'), 100, `${hsl.s}%`)}
            {slider('l', t('color.lightness'), 100, `${hsl.l}%`)}
            <label className="color-value">
              <span>{t('color.value')}</span>
              <input
                type="text"
                spellCheck={false}
                value={typed ?? written}
                aria-invalid={invalid}
                data-testid="color-value"
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
            {invalid && (
              <p className="dialog-hint" role="alert">
                {t('color.invalid')}
              </p>
            )}
          </div>
        </form>
      )}
    </Sheet>
  );
}
