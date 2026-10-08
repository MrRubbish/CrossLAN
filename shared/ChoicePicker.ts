export function bindChoicePicker(picker: HTMLDetailsElement, onChange: (value: string) => void): () => void {
  const trigger = picker.querySelector<HTMLElement>('summary');
  const panel = picker.querySelector<HTMLElement>('.ui-choice-panel');
  if (!trigger || !panel) return () => {};
  let frame = 0;
  let closeTimer = 0;
  let focusTimer = 0;

  function positionPanel(): void {
    if (!picker.open || !panel || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8));
    panel.style.setProperty('--choice-shift', `${left - anchor.left}px`);
    panel.dataset.placement = window.innerHeight - anchor.bottom < bounds.height
      && anchor.top >= bounds.height ? 'above' : 'below';
  }

  function close(restoreFocus = false): void {
    window.clearTimeout(closeTimer);
    picker.open = false;
    if (restoreFocus) trigger?.focus();
  }

  function toggle(): void {
    cancelAnimationFrame(frame);
    if (picker.open) frame = requestAnimationFrame(positionPanel);
  }

  function change(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.type === 'radio' && input.checked) onChange(input.value);
  }

  function closeAfterChange(): void {
    // Let the native radio commit its change before hiding the focused control.
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => { if (picker.open) close(true); }, 0);
  }

  function click(event: MouseEvent): void {
    if (event.target instanceof HTMLInputElement && event.detail > 0) closeAfterChange();
  }

  function preserveOptionFocus(event: MouseEvent): void {
    const option = event.target instanceof Element ? event.target.closest('.ui-choice-option') : null;
    // Label text blurs the trigger on mouse-down, before release activates the radio.
    if (event.button === 0 && option && picker.contains(option)) event.preventDefault();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.target === trigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      picker.open = true;
      picker.querySelector<HTMLInputElement>('input:checked')?.focus();
    } else if (picker.open && event.key === ' ' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      event.target.click();
      closeAfterChange();
    } else if (picker.open && (event.key === 'Escape' || (event.key === 'Enter' && event.target !== trigger))) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  function outside(event: PointerEvent): void {
    if (picker.open && event.target instanceof Node && !picker.contains(event.target)) close();
  }

  function focusout(): void {
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      if (picker.open && !picker.contains(document.activeElement)) close();
    }, 0);
  }

  picker.addEventListener('toggle', toggle);
  picker.addEventListener('change', change);
  picker.addEventListener('click', click);
  picker.addEventListener('mousedown', preserveOptionFocus);
  picker.addEventListener('keydown', keydown);
  picker.addEventListener('focusout', focusout);
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', positionPanel);
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(closeTimer);
    window.clearTimeout(focusTimer);
    picker.removeEventListener('toggle', toggle);
    picker.removeEventListener('change', change);
    picker.removeEventListener('click', click);
    picker.removeEventListener('mousedown', preserveOptionFocus);
    picker.removeEventListener('keydown', keydown);
    picker.removeEventListener('focusout', focusout);
    document.removeEventListener('pointerdown', outside);
    window.removeEventListener('resize', positionPanel);
  };
}
