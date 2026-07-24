// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentChips, type PendingAttachment } from './attachment-chips.js';

// jsdom has no createObjectURL — the component must never need one during
// render (previews come from the STORED previewUrl minted at admission).
const urlApi = URL as unknown as { createObjectURL?: (blob: Blob) => string };

afterEach(() => { delete urlApi.createObjectURL; });

const chip = (over: Partial<PendingAttachment>): PendingAttachment => ({
  key: 'k1',
  file: new File(['abc'], 'doc.txt', { type: 'text/plain' }),
  controller: new AbortController(),
  status: 'uploading',
  progress: 0,
  ...over,
});

describe('AttachmentChips', () => {
  it('renders nothing without items', () => {
    const { container } = render(<AttachmentChips items={[]} onRemove={() => {}} onRetry={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a progress overlay while uploading', () => {
    render(<AttachmentChips items={[chip({ progress: 0.4 })]} onRemove={() => {}} onRetry={() => {}} />);
    expect(screen.getByTestId('chip-uploading').textContent).toContain('40%');
  });

  it('renders a done image chip from the STORED previewUrl, never a fresh object URL per render', () => {
    const createSpy = vi.fn(() => 'blob:freshly-minted');
    urlApi.createObjectURL = createSpy;
    const item = chip({
      key: 'img1',
      file: new File(['x'], 'photo.png', { type: 'image/png' }),
      previewUrl: 'blob:stored-preview',
      status: 'done',
      progress: 1,
      attachment: { url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/photo.png', mime: 'image/png' },
    });
    const { rerender } = render(<AttachmentChips items={[item]} onRemove={() => {}} onRetry={() => {}} />);
    expect((screen.getByAltText('photo.png') as HTMLImageElement).src).toContain('blob:stored-preview');
    rerender(<AttachmentChips items={[item]} onRemove={() => {}} onRetry={() => {}} />);
    expect((screen.getByAltText('photo.png') as HTMLImageElement).src).toContain('blob:stored-preview');
    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('chip-done')).toBeTruthy();
  });

  it('shows name and size for a non-image chip', () => {
    render(<AttachmentChips items={[chip({ status: 'done', progress: 1 })]} onRemove={() => {}} onRetry={() => {}} />);
    expect(screen.getByText('doc.txt')).toBeTruthy();
    expect(screen.getByText(/KB/)).toBeTruthy();
  });

  it('failed chip offers Retry with the error as title and fires onRetry(key)', async () => {
    const onRetry = vi.fn();
    render(
      <AttachmentChips
        items={[chip({ key: 'f1', status: 'failed', error: 'upload failed (500)' })]}
        onRemove={() => {}}
        onRetry={onRetry}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Retry' });
    expect(btn.title).toBe('upload failed (500)');
    expect(screen.getByTestId('chip-failed')).toBeTruthy();
    await userEvent.setup().click(btn);
    expect(onRetry).toHaveBeenCalledWith('f1');
  });

  it('remove button fires onRemove(key)', async () => {
    const onRemove = vi.fn();
    render(<AttachmentChips items={[chip({ key: 'r1' })]} onRemove={onRemove} onRetry={() => {}} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove doc.txt' }));
    expect(onRemove).toHaveBeenCalledWith('r1');
  });
});
