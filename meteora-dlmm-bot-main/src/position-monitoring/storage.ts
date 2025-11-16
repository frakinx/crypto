import fs from 'fs';
import path from 'path';
import type { PositionInfo } from './types.js';

/**
 * Хранилище позиций в JSON файле
 */

const POSITIONS_FILE = path.join(process.cwd(), 'data', 'positions.json');

export class PositionStorage {
  /**
   * Загрузить все позиции из файла
   */
  loadPositions(): PositionInfo[] {
    try {
      if (!fs.existsSync(POSITIONS_FILE)) {
        return [];
      }
      const data = fs.readFileSync(POSITIONS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading positions:', error);
      return [];
    }
  }

  /**
   * Сохранить позиции в файл
   */
  savePositions(positions: PositionInfo[]): void {
    try {
      const dir = path.dirname(POSITIONS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
    } catch (error) {
      console.error('Error saving positions:', error);
    }
  }

  /**
   * Добавить или обновить позицию
   */
  savePosition(position: PositionInfo): void {
    const positions = this.loadPositions();
    const index = positions.findIndex(p => p.positionAddress === position.positionAddress);
    
    if (index >= 0) {
      positions[index] = position;
    } else {
      positions.push(position);
    }
    
    this.savePositions(positions);
  }

  /**
   * Удалить позицию
   */
  removePosition(positionAddress: string): void {
    const positions = this.loadPositions();
    const filtered = positions.filter(p => p.positionAddress !== positionAddress);
    this.savePositions(filtered);
  }

  /**
   * Получить позицию по адресу
   */
  getPosition(positionAddress: string): PositionInfo | undefined {
    const positions = this.loadPositions();
    return positions.find(p => p.positionAddress === positionAddress);
  }

  /**
   * Получить все активные позиции
   */
  getActivePositions(): PositionInfo[] {
    const positions = this.loadPositions();
    return positions.filter(p => p.status === 'active');
  }
}

