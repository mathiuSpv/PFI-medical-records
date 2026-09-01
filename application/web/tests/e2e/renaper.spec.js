// Cubre la verificación de identidad simulada (RENAPER mock, ver
// server/renaper.js): es informativa, no toca el chaincode, así que alcanza
// con probar el widget contra el padrón fijo de sample-data/renaper.json.
import { expect, test } from '@playwright/test';

test.describe('Validación de identidad (RENAPER simulado)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Acciones' })).toBeVisible();
  });

  test('DNI en el padrón muestra nombre y apellido', async ({ page }) => {
    await page.getByPlaceholder('DNI, p.ej. 30111222').fill('30111222');
    await page.getByRole('button', { name: 'Validar identidad' }).click();

    await expect(page.getByText('Lucía Fernández · DNI 30111222')).toBeVisible();
  });

  test('DNI fuera del padrón muestra "no encontrado"', async ({ page }) => {
    await page.getByPlaceholder('DNI, p.ej. 30111222').fill('11111111');
    await page.getByRole('button', { name: 'Validar identidad' }).click();

    await expect(page.getByText('no encontrado en RENAPER')).toBeVisible();
  });

  test('el botón queda deshabilitado sin DNI', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Validar identidad' })).toBeDisabled();
  });
});
