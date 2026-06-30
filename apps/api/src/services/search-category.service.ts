import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { SearchPaper } from '@yarc/shared'
import { config } from '../lib/config.js'

type SavedSearchPaper = SearchPaper & { savedAt: string }

interface SearchCategory {
  id: string
  name: string
  parentId?: string | null
  papers: SavedSearchPaper[]
  createdAt: string
  updatedAt: string
}

interface SearchCategoriesData {
  categories: SearchCategory[]
}

export class SearchCategoryService {
  private dataPath: string
  private data: SearchCategoriesData

  constructor() {
    // 使用项目根目录下的 data 文件夹
    this.dataPath = join(config.dataDir, 'search-categories.json')
    this.data = this.loadData()
  }

  private loadData(): SearchCategoriesData {
    try {
      // 确保目录存在
      const dir = dirname(this.dataPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      if (existsSync(this.dataPath)) {
        const content = readFileSync(this.dataPath, 'utf-8')
        return JSON.parse(content)
      }
    } catch (err) {
      console.error('Failed to load search categories:', err)
    }

    // 返回默认数据
    return {
      categories: [
        {
          id: 'default',
          name: '搜索收藏',
          parentId: null,
          papers: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    }
  }

  private saveData(): void {
    try {
      const dir = dirname(this.dataPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save search categories:', err)
      throw new Error('保存失败')
    }
  }

  private assertValidParent(id: string | null, parentId: string | null | undefined): void {
    if (!parentId) return
    if (id && parentId === id) {
      throw new Error('分类不能作为自己的父分类')
    }

    const parent = this.data.categories.find(c => c.id === parentId)
    if (!parent) {
      throw new Error('父分类不存在')
    }

    let cursor = parent.parentId || null
    while (cursor) {
      if (id && cursor === id) {
        throw new Error('分类不能移动到自己的子分类下')
      }
      const next = this.data.categories.find(c => c.id === cursor)
      cursor = next?.parentId || null
    }
  }

  // 获取所有分类
  getCategories(): SearchCategory[] {
    return this.data.categories
  }

  // 获取分类树结构
  getCategoryTree(): Array<SearchCategory & { children: SearchCategory[] }> {
    const roots: Array<SearchCategory & { children: SearchCategory[] }> = []
    const map = new Map<string, SearchCategory & { children: SearchCategory[] }>()

    // 创建映射
    for (const cat of this.data.categories) {
      map.set(cat.id, { ...cat, children: [] })
    }

    // 构建树
    for (const cat of this.data.categories) {
      const node = map.get(cat.id)!
      if (cat.parentId && map.has(cat.parentId)) {
        map.get(cat.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }

    return roots
  }

  // 获取单个分类
  getCategory(id: string): SearchCategory | undefined {
    return this.data.categories.find(c => c.id === id)
  }

  // 创建分类
  createCategory(name: string, parentId?: string | null): SearchCategory {
    this.assertValidParent(null, parentId)

    const id = `cat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const now = new Date().toISOString()
    
    const category: SearchCategory = {
      id,
      name,
      parentId: parentId || null,
      papers: [],
      createdAt: now,
      updatedAt: now
    }

    this.data.categories.push(category)
    this.saveData()
    return category
  }

  // 更新分类
  updateCategory(id: string, updates: Partial<Pick<SearchCategory, 'name' | 'parentId'>>): SearchCategory {
    const index = this.data.categories.findIndex(c => c.id === id)
    if (index === -1) {
      throw new Error('分类不存在')
    }

    if (updates.name !== undefined) {
      this.data.categories[index].name = updates.name
    }
    if (updates.parentId !== undefined) {
      this.assertValidParent(id, updates.parentId)
      this.data.categories[index].parentId = updates.parentId
    }
    this.data.categories[index].updatedAt = new Date().toISOString()

    this.saveData()
    return this.data.categories[index]
  }

  // 删除分类
  deleteCategory(id: string): void {
    const index = this.data.categories.findIndex(c => c.id === id)
    if (index === -1) {
      throw new Error('分类不存在')
    }

    // 删除该分类下的所有论文
    this.data.categories.splice(index, 1)

    // 将子分类的 parentId 设为 null
    for (const cat of this.data.categories) {
      if (cat.parentId === id) {
        cat.parentId = null
      }
    }

    this.saveData()
  }

  // 添加论文到分类
  addPaper(categoryId: string, paper: SearchPaper): SavedSearchPaper {
    const category = this.data.categories.find(c => c.id === categoryId)
    if (!category) {
      throw new Error('分类不存在')
    }

    // 检查是否已存在
    const existing = category.papers.find(p => p.id === paper.id)
    if (existing) {
      throw new Error('论文已存在于此分类')
    }

    const savedPaper: SavedSearchPaper = {
      ...paper,
      savedAt: new Date().toISOString()
    }

    category.papers.push(savedPaper)
    category.updatedAt = new Date().toISOString()
    this.saveData()
    return savedPaper
  }

  // 批量添加论文到分类
  addPapers(categoryId: string, papers: SearchPaper[]): SavedSearchPaper[] {
    const category = this.data.categories.find(c => c.id === categoryId)
    if (!category) {
      throw new Error('分类不存在')
    }

    const savedPapers: SavedSearchPaper[] = []
    const now = new Date().toISOString()

    for (const paper of papers) {
      // 检查是否已存在
      const existing = category.papers.find(p => p.id === paper.id)
      if (!existing) {
        const savedPaper: SavedSearchPaper = {
          ...paper,
          savedAt: now
        }
        category.papers.push(savedPaper)
        savedPapers.push(savedPaper)
      }
    }

    category.updatedAt = now
    this.saveData()
    return savedPapers
  }

  // 从分类中删除论文
  removePaper(categoryId: string, paperId: string): void {
    const category = this.data.categories.find(c => c.id === categoryId)
    if (!category) {
      throw new Error('分类不存在')
    }

    const index = category.papers.findIndex(p => p.id === paperId)
    if (index === -1) {
      throw new Error('论文不存在于此分类')
    }

    category.papers.splice(index, 1)
    category.updatedAt = new Date().toISOString()
    this.saveData()
  }

  // 移动论文到另一个分类
  movePaper(fromCategoryId: string, toCategoryId: string, paperId: string): void {
    const fromCategory = this.data.categories.find(c => c.id === fromCategoryId)
    if (!fromCategory) {
      throw new Error('源分类不存在')
    }

    const toCategory = this.data.categories.find(c => c.id === toCategoryId)
    if (!toCategory) {
      throw new Error('目标分类不存在')
    }

    const paperIndex = fromCategory.papers.findIndex(p => p.id === paperId)
    if (paperIndex === -1) {
      throw new Error('论文不存在于源分类')
    }

    const paper = fromCategory.papers.splice(paperIndex, 1)[0]
    toCategory.papers.push(paper)

    const now = new Date().toISOString()
    fromCategory.updatedAt = now
    toCategory.updatedAt = now
    this.saveData()
  }

  // 获取分类中的论文列表
  getPapers(categoryId: string): SavedSearchPaper[] {
    const category = this.data.categories.find(c => c.id === categoryId)
    if (!category) {
      throw new Error('分类不存在')
    }
    return category.papers
  }

  // 搜索论文（在所有分类中）
  searchPapers(query: string): Array<{ category: SearchCategory; paper: SavedSearchPaper }> {
    const results: Array<{ category: SearchCategory; paper: SavedSearchPaper }> = []
    const lowerQuery = query.toLowerCase()

    for (const category of this.data.categories) {
      for (const paper of category.papers) {
        const matchTitle = paper.title.toLowerCase().includes(lowerQuery)
        const matchAuthors = paper.authors.some(a => a.toLowerCase().includes(lowerQuery))
        const matchAbstract = paper.abstract?.toLowerCase().includes(lowerQuery)
        const matchYear = paper.year?.toString().includes(query)

        if (matchTitle || matchAuthors || matchAbstract || matchYear) {
          results.push({ category, paper })
        }
      }
    }

    return results
  }
}

export const searchCategoryService = new SearchCategoryService()
